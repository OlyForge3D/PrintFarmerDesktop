import { mkdtemp, readFile, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ArchiveSettings, DEFAULT_MAX_ARCHIVE_BYTES } from '@shared/ipc';
import { ArchiveSettingsStore } from '../src/main/archiveSettings';
import { ArchiveSettingsSection } from '../src/renderer/shell/ArchiveSettingsSection';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pf-archive-settings-'));
  roots.push(root);
  return root;
}

describe('ZIP settings persistence and validation', () => {
  it('defaults to 512 MiB and persists a validated change across instances', async () => {
    const root = await temporaryRoot();
    const store = new ArchiveSettingsStore(root);
    expect(await store.get()).toEqual({
      maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES,
    });
    await store.set({ maxArchiveBytes: 1024 * 1024 * 1024 });
    expect(await new ArchiveSettingsStore(root).get()).toEqual({
      maxArchiveBytes: 1024 * 1024 * 1024,
    });
    expect(
      JSON.parse(
        await readFile(path.join(root, 'archive-settings.v1.json'), 'utf8'),
      ),
    ).toEqual({
      version: 1,
      settings: { maxArchiveBytes: 1024 * 1024 * 1024 },
    });
  });

  it.each([
    0,
    -1,
    1024 * 1024 - 1,
    1.5 * 1024 * 1024,
    16384 * 1024 * 1024 + 1,
    Infinity,
    NaN,
  ])(
    'rejects invalid byte limit %s without writing',
    async (maxArchiveBytes) => {
      const root = await temporaryRoot();
      const store = new ArchiveSettingsStore(root);
      expect(ArchiveSettings.safeParse({ maxArchiveBytes }).success).toBe(
        false,
      );
      await expect(store.set({ maxArchiveBytes })).rejects.toThrow();
      expect(await store.get()).toEqual({
        maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES,
      });
    },
  );

  it('does not silently replace corrupt settings with a success-shaped default', async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, 'archive-settings.v1.json'),
      '{"version":1,"settings":{"maxArchiveBytes":0}}',
    );
    await expect(new ArchiveSettingsStore(root).get()).rejects.toThrow(
      'Could not read ZIP settings.',
    );
  });

  it('checks archived sources before cache hits at the exact configured threshold', async () => {
    const root = await temporaryRoot();
    const store = new ArchiveSettingsStore(root);
    await store.set({ maxArchiveBytes: 1024 * 1024 });
    const archive = path.join(root, 'parts.zip');
    const file = await open(archive, 'w');
    try {
      await file.truncate(1024 * 1024);
      const locator = `${archive}/::zip::/0/part.stl`;
      await expect(store.assertSourceAllowed(locator)).resolves.toBeUndefined();
      await file.truncate(1024 * 1024 + 1);
      await expect(store.assertSourceAllowed(locator)).rejects.toThrow(
        'exceeds the 1 MiB limit (1048576 bytes)',
      );
      await store.set({ maxArchiveBytes: 2 * 1024 * 1024 });
      await expect(store.assertSourceAllowed(locator)).resolves.toBeUndefined();
      await expect(
        store.assertSourceAllowed(path.join(root, 'model.3mf')),
      ).resolves.toBeUndefined();
    } finally {
      await file.close();
    }
  });
});

describe('Maximum ZIP size control', () => {
  function installApi() {
    const api = {
      getArchiveSettings: vi
        .fn()
        .mockResolvedValue({ maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES }),
      setArchiveSettings: vi
        .fn()
        .mockImplementation((settings: { maxArchiveBytes: number }) =>
          Promise.resolve(settings),
        ),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });
    return api;
  }
  it('loads the persisted value, validates input and saves in bytes with feedback', async () => {
    const api = installApi();
    const onBusyChange = vi.fn();
    render(
      <ArchiveSettingsSection disabled={false} onBusyChange={onBusyChange} />,
    );
    const input = await screen.findByDisplayValue('512');
    for (const value of ['', '0', '1.5', '16385']) {
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Save ZIP limit' }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Enter a whole number from 1 to 16384 MiB.',
      );
    }
    expect(api.setArchiveSettings).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '1024' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ZIP limit' }));
    await waitFor(() =>
      expect(api.setArchiveSettings).toHaveBeenCalledWith({
        maxArchiveBytes: 1024 * 1024 * 1024,
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'It applies to the next scan or rescan.',
    );
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it('reports loading failures and offers a retry without enabling an unsaved default', async () => {
    const api = installApi();
    api.getArchiveSettings.mockRejectedValueOnce(
      new Error('Settings are unreadable'),
    );
    render(<ArchiveSettingsSection disabled={false} onBusyChange={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Settings are unreadable',
    );
    expect(
      screen.getByRole('button', { name: 'Save ZIP limit' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry ZIP settings' }));
    expect(await screen.findByDisplayValue('512')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Save ZIP limit' }),
    ).toBeEnabled();
  });
});
