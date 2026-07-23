import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  LogicalModel,
  PrintFarmerApi,
  ServerProfile,
  UploadJob,
} from '@shared/ipc';
import { App } from '../src/renderer/App.js';
import { UploadQueueDialog } from '../src/renderer/uploads/UploadQueueDialog.js';

const models: LogicalModel[] = ['a', 'b', 'c'].map((name, index) => ({
  hash: String(index + 1).repeat(64),
  format: 'stl',
  size: 100 + index,
  locations: [
    {
      rootId: 'root',
      path: `C:\\models\\${name}.stl`,
      rootRelative: `${name}.stl`,
      size: 100 + index,
      available: true,
    },
  ],
}));

describe('catalog multi-selection and upload queue UI', () => {
  it('supports normal, modifier, visible-range, select-all, and clear selection', async () => {
    installApi({});
    render(<App />);
    const a = await screen.findByRole('button', { name: 'Select a.stl' });
    fireEvent.click(a);
    expect(screen.getByText('1 selected')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Select b.stl' }), {
      ctrlKey: true,
    });
    expect(screen.getByText('2 selected')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Select c.stl' }), {
      shiftKey: true,
    });
    expect(screen.getByText('2 selected')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Select a.stl' }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.getByRole('button', { name: 'Deselect c.stl' }),
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Select all visible' }));
    expect(screen.getByText('3 selected')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByText('0 selected')).toBeVisible();
  });

  it('opens one accessible queue modal, warns for legacy mode, and restores focus', async () => {
    const startUploadJob = vi.fn(() => Promise.resolve(uploadJob()));
    installApi({
      listServerProfiles: vi.fn().mockResolvedValue({
        profiles: [legacyProfile()],
        selectedProfileId: legacyProfile().id,
      }),
      startUploadJob,
    });
    const { container } = render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Select a.stl' }),
    );
    const upload = screen.getByRole('button', {
      name: 'Upload to PrintFarmer',
    });
    await waitFor(() => expect(upload).toBeEnabled());
    upload.focus();
    fireEvent.click(upload);

    const dialog = screen.getByRole('dialog', { name: 'Upload queue' });
    expect(dialog).toBeVisible();
    expect(container.querySelector('.workspace')).toHaveAttribute('inert');
    expect(
      screen.getAllByText(/interrupted retries may/i).length,
    ).toBeGreaterThan(0);
    expect(startUploadJob).toHaveBeenCalledWith({
      profileId: legacyProfile().id,
      hashes: [models[0]!.hash],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close upload queue' }));
    await waitFor(() => expect(upload).toHaveFocus());
    expect(container.querySelector('.workspace')).not.toHaveAttribute('inert');
  });

  it('requires explicit legacy-risk confirmation and offers deliberate reset recovery', () => {
    const job = uploadJob();
    job.state = 'attention';
    job.items[0]!.state = 'uncertain';
    job.items[0]!.error = {
      code: 'LEGACY_UPLOAD_UNCERTAIN',
      message: 'Bytes may have reached the server.',
      retryable: false,
      retryAfterSeconds: null,
      duplicateRisk: true,
    };
    job.summary = {
      queued: 0,
      uploading: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      uncertain: 1,
    };
    const confirm = vi.fn();
    const reset = vi.fn();
    render(
      <UploadQueueDialog
        jobs={[job]}
        busy={false}
        error="The upload queue is corrupt."
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onConfirmLegacyRetry={confirm}
        onRemove={vi.fn()}
        onReset={reset}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Retry incomplete' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'I understand—retry legacy upload',
      }),
    );
    expect(confirm).toHaveBeenCalledWith(job.id);
    fireEvent.click(
      screen.getByRole('button', { name: 'Reset queue (keep backup)' }),
    );
    expect(reset).toHaveBeenCalledOnce();
  });
});

function installApi(overrides: Partial<PrintFarmerApi>): void {
  const api: Partial<PrintFarmerApi> = {
    getAppInfo: vi.fn().mockResolvedValue({
      contractVersion: 1,
      appVersion: '0.1.0',
      platform: 'win32',
      electronVersion: '33',
    }),
    listModels: vi.fn().mockResolvedValue(models),
    listServerProfiles: vi.fn().mockResolvedValue({
      profiles: [],
      selectedProfileId: null,
    }),
    listUploadJobs: vi.fn().mockResolvedValue([]),
    renderThumbnail: vi.fn().mockRejectedValue(new Error('not rendered')),
    ...overrides,
  };
  Object.defineProperty(window, 'printFarmer', {
    value: api,
    configurable: true,
  });
}

function legacyProfile(): ServerProfile {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Legacy farm',
    baseUrl: 'https://legacy.example',
    authMode: 'apiKey',
    version: null,
    capabilities: {
      architecture: 'x64',
      slicingEnabled: true,
      modelFilesEnabled: true,
      thumbnailGenerationEnabled: true,
      gcodeUploadEnabled: true,
      clientThumbnailUploadEnabled: false,
      idempotentModelUploadEnabled: false,
      modelThumbnailReplacementEnabled: false,
      platformNote: null,
    },
    availability: {
      modelUpload: {
        available: true,
        mode: 'legacyModelOnly',
        reason: 'Legacy fallback',
      },
      librarySync: { available: false, reason: 'Unavailable' },
      clientThumbnailUpload: { available: false, reason: 'Unavailable' },
      serverThumbnailFallback: { available: true, reason: 'Server thumbnails' },
    },
    status: 'legacy',
    lastCheckedAt: '2026-07-23T20:00:00.000Z',
    warnings: ['legacy'],
  };
}

function uploadJob(): UploadJob {
  const timestamp = '2026-07-23T20:00:00.000Z';
  return {
    id: '22222222-2222-4222-8222-222222222222',
    profileId: legacyProfile().id,
    profileName: 'Legacy farm',
    profileRevision: 'revision-1',
    mode: 'legacyModelOnly',
    state: 'running',
    paused: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    items: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        hash: models[0]!.hash,
        clientUploadId: '44444444-4444-4444-8444-444444444444',
        displayName: 'a.stl',
        size: 100,
        state: 'queued',
        bytesSent: 0,
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        remote: null,
        error: null,
      },
    ],
    totalBytes: 100,
    bytesSent: 0,
    summary: {
      queued: 1,
      uploading: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      uncertain: 0,
    },
  };
}
