import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { scanOutcomeCounts } from '../src/renderer/library/ScanFeedback';
import { ImportWizard } from '../src/renderer/library/ImportWizard';

describe('compact import scan outcomes', () => {
  it('counts mutually exclusive skipped categories once, not their legacy duplicates or path samples', () => {
    expect(
      scanOutcomeCounts({
        skippedErrors: 7,
        cloudFilesSkipped: 12062,
        cloudDirectoriesSkipped: 0,
        skippedEntries: {
          cloudOnly: 12062,
          permissionDenied: 0,
          unreadable: 1,
          tooLarge: 6,
        },
        archiveWarnings: Array.from(
          { length: 6 },
          (_, index) => `archive-${index}.zip`,
        ),
        scanIssues: [
          {
            path: '/models/archive-0.zip',
            reason: 'tooLarge',
            kind: 'file',
            detail: 'Too large',
          },
        ],
      }),
    ).toEqual({
      skipped: 12069,
      cloudOnly: 12062,
      permissionDenied: 0,
      unreadable: 1,
      filesystemErrors: 0,
      tooLarge: 6,
    });
    expect(
      scanOutcomeCounts({
        skippedErrors: 2,
        cloudFilesSkipped: 4,
        cloudDirectoriesSkipped: 1,
        archiveWarnings: ['large.zip'],
      }),
    ).toEqual({
      skipped: 8,
      cloudOnly: 5,
      permissionDenied: 0,
      unreadable: 0,
      filesystemErrors: 2,
      tooLarge: 1,
    });
    expect(
      scanOutcomeCounts({
        skippedEntries: {
          cloudOnly: 0,
          permissionDenied: 2,
          unreadable: 3,
          tooLarge: 0,
        },
        skippedErrors: 5,
      }).skipped,
    ).toBe(5);
  });

  it('keeps scan counts in the top summary and recovery behind a keyboard-accessible compact disclosure', () => {
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: { previewImport: vi.fn() },
    });
    const retry = vi.fn();
    const props = {
      draft: {
        rootId: 'scan-outcomes',
        approvalId: '11111111-1111-4111-8111-111111111111',
        path: '/models',
        collections: [],
        tags: [],
        preview: {
          modelCount: 2277,
          totalBytes: 1200,
          skippedErrors: 7,
          complete: true,
          formats: { stl: 2277, threeMf: 0, obj: 0 },
          folders: [],
          foldersTruncated: false,
          cloudFilesSkipped: 12062,
          cloudDirectoriesSkipped: 0,
          skippedEntries: {
            cloudOnly: 12062,
            permissionDenied: 0,
            unreadable: 1,
            tooLarge: 6,
          },
          scanIssues: [
            {
              path: '/models/online.stl',
              reason: 'cloudOnly' as const,
              kind: 'file' as const,
              detail: 'Online-only file',
            },
          ],
        },
      },
      busy: true,
      error: null,
      onCancel: vi.fn(),
      onDismissError: vi.fn(),
      onConfirm: vi.fn().mockResolvedValue(true),
      onRetryScan: retry,
      retryLabel: 'Retry folder scan',
    };
    const { rerender } = render(<ImportWizard {...props} />);
    const summary = screen.getByLabelText('Import summary');
    for (const [label, value] of [
      ['Model files', '2277'],
      ['Skipped entries', '12069'],
      ['Cloud-only', '12062'],
      ['Unreadable', '1'],
      ['Oversized ZIPs', '6'],
    ] as const) {
      expect(within(summary).getByText(label).parentElement).toHaveTextContent(
        value,
      );
    }
    const disclosure = screen.getByText('Skipped paths and scan details');
    expect(disclosure.closest('details')).not.toHaveProperty('open', true);
    fireEvent.click(disclosure);
    expect(
      screen.getByText(/Make cloud-only items available locally/),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Retry folder scan' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByText('Show skipped paths and details'));
    expect(screen.getByText('/models/online.stl')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    rerender(<ImportWizard {...props} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry folder scan' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
