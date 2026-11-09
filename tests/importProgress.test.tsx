import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import type {
  ImportPreviewResponse,
  ImportRootResponse,
  PrintFarmerApi,
} from '@shared/ipc';
import { withModelPaging } from './helpers/libraryPage';
import { ImportWizard } from '../src/renderer/library/ImportWizard.js';
import {
  useLibrary,
  type ImportDraft,
} from '../src/renderer/library/useLibrary.js';

const approvalId = '11111111-1111-4111-8111-111111111111';

const largePreview: ImportPreviewResponse = {
  modelCount: 2277,
  totalBytes: 9_000_000_000,
  skippedErrors: 0,
  complete: true,
  formats: { stl: 2000, threeMf: 200, obj: 77 },
  folders: Array.from({ length: 500 }, (_, index) => ({
    relativePath: `Folder ${index}`,
    name: `Folder ${index}`,
    depth: 1,
    modelCount: 4,
  })),
  foldersTruncated: true,
};

const draft: ImportDraft = {
  rootId: 'root-progress',
  approvalId,
  path: 'C:\\Huge Library',
  preview: largePreview,
  collections: [],
  tags: [],
};

const importResult: ImportRootResponse = {
  report: { added: 2277, changed: 0, unchanged: 0, missing: 0, hashErrors: 0 },
  modelsOrganized: 2277,
  collectionsCreated: 0,
  collectionAssignments: 0,
  tagAssignments: 0,
  resolvedCollections: [],
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function installApi(api: Partial<PrintFarmerApi>): void {
  Object.defineProperty(window, 'printFarmer', {
    value: withModelPaging(api),
    configurable: true,
    writable: true,
  });
}

function progressStatus(): HTMLElement {
  return screen.getByRole('status', { name: 'Import progress' });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('import wizard progress', () => {
  it('shows nothing in the progress region before an import starts', () => {
    render(
      <ImportWizard
        draft={draft}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(true)}
      />,
    );
    expect(progressStatus()).toBeEmptyDOMElement();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false');
  });

  it('shows an indeterminate state immediately on submit and ignores repeat clicks', async () => {
    const pending = deferred<boolean>();
    const onConfirm = vi.fn().mockReturnValue(pending.promise);
    render(
      <ImportWizard
        draft={draft}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const importButton = screen.getByRole('button', {
      name: 'Import 2277 files',
    });
    fireEvent.click(importButton);
    fireEvent.click(importButton);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(progressStatus()).toHaveTextContent('Importing 2,277 files');
    expect(progressStatus()).toHaveTextContent('Starting import.');
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('value');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Importing...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/\d+\s*%/);
    expect(document.activeElement).toBe(progressStatus().parentElement);

    await act(async () => {
      pending.resolve(false);
      await pending.promise;
    });
    expect(progressStatus()).toBeEmptyDOMElement();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Import 2277 files' }),
    ).toBeEnabled();
  });

  it('clears the running state when the confirm handler throws', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('boom'));
    render(
      <ImportWizard
        draft={draft}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import 2277 files' }));
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: 'Import 2277 files' }),
    ).toBeEnabled();
  });

  it('reports truthful stages and a running elapsed time without a percentage', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ImportWizard
        draft={draft}
        busy
        importStage="importing"
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(progressStatus()).toHaveTextContent(
      'Rescanning the source folder and applying organization rules',
    );
    expect(progressStatus()).toHaveTextContent(
      'per-file progress is not available',
    );
    expect(screen.getByText('Elapsed 0:00')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(screen.getByText('Elapsed 1:05')).toBeInTheDocument();
    // Elapsed time lives outside the live region so it is not re-announced.
    expect(progressStatus()).not.toHaveTextContent('Elapsed');

    rerender(
      <ImportWizard
        draft={draft}
        busy
        importStage="refreshing"
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(progressStatus()).toHaveTextContent('Refreshing library');
    expect(screen.getByText('Elapsed 1:05')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/\d+\s*%/);
  });

  it('describes a zero-model confirmation as reconciliation', () => {
    render(
      <ImportWizard
        draft={{ ...draft, preview: { ...largePreview, modelCount: 0 } }}
        busy
        importStage="importing"
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(progressStatus()).toHaveTextContent('Reconciling source');
  });
});

describe('library import stages', () => {
  function setup(importRoot: PrintFarmerApi['importRoot']): {
    listModels: ReturnType<typeof vi.fn>;
    refreshGate: ReturnType<typeof deferred<[]>>;
    gateRefresh: { on: boolean };
  } {
    const refreshGate = deferred<[]>();
    const gateRefresh = { on: false };
    const listModels = vi.fn(() =>
      gateRefresh.on ? refreshGate.promise : Promise.resolve([]),
    );
    installApi({
      openFolder: vi.fn().mockResolvedValue({ path: draft.path, approvalId }),
      previewImport: vi.fn().mockResolvedValue(largePreview),
      importRoot,
      listModels,
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });
    return { listModels, refreshGate, gateRefresh };
  }

  it('moves from importing to refreshing and clears on success', async () => {
    const importGate = deferred<ImportRootResponse>();
    const importRoot = vi.fn().mockReturnValue(importGate.promise);
    const { listModels, refreshGate, gateRefresh } = setup(importRoot);
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalled());
    await act(async () => result.current.addFolder());

    let confirm!: Promise<ImportRootResponse | null>;
    act(() => {
      confirm = result.current.confirmImport({ rules: [], commonTags: [] });
    });
    expect(result.current.status).toBe('scanning');
    expect(result.current.scanActivity.importStage).toBe('importing');
    expect(result.current.scanActivity.backendProgressAvailable).toBe(false);

    gateRefresh.on = true;
    await act(async () => {
      importGate.resolve(importResult);
      await importGate.promise;
    });
    await waitFor(() =>
      expect(result.current.scanActivity.importStage).toBe('refreshing'),
    );
    expect(result.current.status).toBe('scanning');
    expect(result.current.importDraft).not.toBeNull();

    await act(async () => {
      refreshGate.resolve([]);
      await confirm;
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.scanActivity.phase).toBe('idle');
    expect(result.current.scanActivity.importStage).toBeUndefined();
    expect(result.current.importDraft).toBeNull();
  });

  it('clears the import stage and keeps the draft on a reported failure', async () => {
    const importRoot = vi.fn().mockResolvedValue({
      ...importResult,
      report: { ...importResult.report, failure: 'Scan policy refused root.' },
    });
    const { listModels } = setup(importRoot);
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalled());
    await act(async () => result.current.addFolder());
    await act(async () =>
      result.current.confirmImport({ rules: [], commonTags: [] }),
    );
    expect(result.current.error).toBe('Scan policy refused root.');
    expect(result.current.status).toBe('idle');
    expect(result.current.scanActivity.importStage).toBeUndefined();
    expect(result.current.importDraft).not.toBeNull();
  });

  it('clears the import stage when the import request rejects', async () => {
    const importRoot = vi.fn().mockRejectedValue(new Error('sidecar exited'));
    const { listModels } = setup(importRoot);
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalled());
    await act(async () => result.current.addFolder());
    await act(async () =>
      result.current.confirmImport({ rules: [], commonTags: [] }),
    );
    expect(result.current.error).toBe('sidecar exited');
    expect(result.current.status).toBe('idle');
    expect(result.current.scanActivity.importStage).toBeUndefined();
    expect(result.current.importDraft).not.toBeNull();
  });
});
